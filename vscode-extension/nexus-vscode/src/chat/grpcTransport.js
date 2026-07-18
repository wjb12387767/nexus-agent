/**
 * GrpcTransport — 通过 spawn `nexus grpc-cli` 子进程桥接 M5 gRPC server。
 *
 * 当 `nexus.transportMode === 'grpc'` 时，ChatController 使用本类替代 ProcessManager。
 * 本类暴露与 ProcessManager 相同的事件接口（onMessage/onError/onExit）和方法
 * （start/sendUserMessage/sendControlResponse/abort/kill/dispose），但底层通过
 * `nexus grpc-cli --host <host> --port <port>` 子进程与运行中的
 * `nexus grpc --port <port>` server 通信。
 *
 * gRPC CLI 的 stdout 是人类可读的格式化文本（如 `[工具开始] ...`、`[完成] ...`），
 * 本类将其逐行解析为 NDJSON 形状的消息，喂给 ChatController._handleMessage。
 * 这是一种尽力而为的桥接——完整语义需要 gRPC CLI 支持 NDJSON 输出模式（未来增强）。
 *
 * 使用前请先在另一个终端启动 server：
 *   nexus grpc --port 50051
 */

const { spawn } = require('child_process');
const vscode = require('vscode');

class GrpcTransport {
  /**
   * @param {object} opts
   * @param {string} opts.command - nexus CLI 入口（用于定位 grpc-cli 子命令），默认 'nexus'
   * @param {string} opts.endpoint - gRPC server 端点，如 'localhost:50051'
   * @param {string} [opts.cwd] - 工作目录
   * @param {Record<string,string>} [opts.env] - 额外环境变量
   * @param {string} [opts.sessionId] - 要恢复的会话 ID
   * @param {string} [opts.model] - 模型覆盖
   */
  constructor(opts) {
    this._command = opts.command || 'nexus';
    this._endpoint = opts.endpoint || 'localhost:50051';
    this._cwd = opts.cwd || undefined;
    this._env = opts.env || {};
    this._sessionId = opts.sessionId || null;
    this._model = opts.model || null;
    this._process = null;
    this._buffer = '';
    this._disposed = false;
    // 解析端点为 host/port，传给 grpc-cli
    const [host, port] = this._endpoint.split(':');
    this._host = host || 'localhost';
    this._port = port || '50051';

    this._onMessageEmitter = new vscode.EventEmitter();
    this._onErrorEmitter = new vscode.EventEmitter();
    this._onExitEmitter = new vscode.EventEmitter();
    this.onMessage = this._onMessageEmitter.event;
    this.onError = this._onErrorEmitter.event;
    this.onExit = this._onExitEmitter.event;
  }

  get running() {
    return this._process !== null && !this._process.killed;
  }

  get sessionId() {
    return this._sessionId;
  }

  start() {
    if (this._disposed) throw new Error('GrpcTransport is disposed');
    if (this._process) throw new Error('Process already started');

    // 构造 `nexus grpc-cli` 参数
    const args = [
      'grpc-cli',
      '--host', this._host,
      '--port', this._port,
    ];
    if (this._cwd) args.push('--cwd', this._cwd);
    if (this._model) args.push('--model', this._model);
    if (this._sessionId) args.push('--session', this._sessionId);

    const spawnEnv = { ...process.env, ...this._env };
    const isWin = process.platform === 'win32';

    if (isWin) {
      // Windows 上 npm 全局安装会生成 .cmd shim，需要 shell 才能找到
      const cmdLine = [this._command, ...args].join(' ');
      this._process = spawn(cmdLine, [], {
        cwd: this._cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    } else {
      this._process = spawn(this._command, args, {
        cwd: this._cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    this._process.stdout.setEncoding('utf8');
    this._process.stderr.setEncoding('utf8');

    this._process.stdout.on('data', (chunk) => this._onData(chunk));
    this._process.stderr.on('data', (chunk) => this._onStderr(chunk));
    this._process.on('error', (err) => this._onErrorEmitter.fire(err));
    this._process.on('close', (code, signal) => {
      this._process = null;
      this._onExitEmitter.fire({ code, signal });
    });

    // 发送初始 system 消息，让 ChatController 知道连接已建立
    this._emitMessage({
      type: 'system',
      model: this._model || null,
      session_id: this._sessionId || null,
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      const msg = this._parseGrpcCliLine(line);
      if (msg) {
        if (msg.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
        }
        this._onMessageEmitter.fire(msg);
      }
    }
  }

  /**
   * 将 `nexus grpc-cli` 的一行输出解析为 NDJSON 形状消息。
   * 尽力而为——无法识别的行作为 text_delta 流式输出。
   */
  _parseGrpcCliLine(line) {
    const text = line.trim();
    if (!text) return null;

    // 跳过 grpc-cli 的连接提示行
    if (/^连接到 Nexus gRPC server/.test(text)) return null;
    if (/^已连接/.test(text)) return null;
    if (/^会话:/.test(text)) return null;
    if (/^nexus>\s*$/.test(text)) return null;

    // [完成] prompt_tokens=<> completion_tokens=<>
    const doneMatch = text.match(/^\[完成\]\s+prompt_tokens=(\d+)\s+completion_tokens=(\d+)/);
    if (doneMatch) {
      return {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: parseInt(doneMatch[1], 10),
          output_tokens: parseInt(doneMatch[2], 10),
        },
        num_turns: 1,
        stop_reason: 'done',
      };
    }

    // [错误] <code>: <message>
    const errMatch = text.match(/^\[错误\]\s+(\d+):\s*(.*)$/);
    if (errMatch) {
      this._onErrorEmitter.fire(new Error(`${errMatch[1]}: ${errMatch[2]}`));
      return null;
    }

    // [需要操作] (<type>) prompt_id=<id>\n  <question>
    const actionMatch = text.match(/^\[需要操作\]\s+\(([^)]+)\)\s+prompt_id=(\S+)/);
    if (actionMatch) {
      return {
        type: 'control_request',
        request_id: actionMatch[2],
        request: {
          tool_name: 'ActionRequired',
          description: text,
          permission_suggestions: [],
        },
      };
    }

    // [工具开始] <name> (id=<id>)
    const toolStartMatch = text.match(/^\[工具开始\]\s+(\S+)\s+\(id=(\S+)\)/);
    if (toolStartMatch) {
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: toolStartMatch[2],
            name: toolStartMatch[1],
            input: {},
          },
        },
      };
    }

    // [工具完成] <name> (id=<id>) 或 [工具错误] ...
    const toolResultMatch = text.match(/^\[工具(完成|错误)\]\s+(\S+)\s+\(id=(\S+)\)/);
    if (toolResultMatch) {
      const isError = toolResultMatch[1] === '错误';
      return {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolResultMatch[3],
            content: text,
            is_error: isError,
          }],
        },
      };
    }

    // 其他行视为助手文本增量
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: text + '\n',
        },
      },
    };
  }

  _emitMessage(msg) {
    this._onMessageEmitter.fire(msg);
  }

  _onStderr(chunk) {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    if (/^\(node:\d+\)|^DeprecationWarning|^ExperimentalWarning/i.test(trimmed)) return;
    this._onErrorEmitter.fire(new Error(trimmed));
  }

  sendUserMessage(text) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('Process is not running');
    }
    // grpc-cli REPL 读取每行作为一条消息
    this._process.stdin.write(text + '\n');
  }

  sendControlResponse(requestId, result) {
    if (!this._process || !this._process.stdin.writable) return;
    // 对于 ActionRequired，grpc-cli 会提示输入应答；直接写入回复文本
    const reply = (result && result.behavior === 'deny') ? 'deny' : 'allow';
    this._process.stdin.write(reply + '\n');
  }

  write(msg) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('Process is not running');
    }
    this._process.stdin.write(JSON.stringify(msg) + '\n');
  }

  abort() {
    if (this._process && !this._process.killed && this._process.stdin.writable) {
      // 发送 /abort 命令给 grpc-cli REPL
      this._process.stdin.write('/abort\n');
    }
  }

  kill() {
    if (this._process && !this._process.killed) {
      this._process.kill('SIGTERM');
    }
  }

  dispose() {
    this._disposed = true;
    this.kill();
    this._onMessageEmitter.dispose();
    this._onErrorEmitter.dispose();
    this._onExitEmitter.dispose();
  }
}

module.exports = { GrpcTransport };
