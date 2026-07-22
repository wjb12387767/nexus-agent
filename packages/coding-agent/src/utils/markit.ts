import * as path from "node:path";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { ConversionResult, Markit, StreamInfo } from "../markit";
import { ToolAbortError } from "../tools/tool-errors";
import {
	type MarkitConversionCacheStatus,
	markitConversionCacheKey,
	readMarkitConversionCache,
	writeMarkitConversionCache,
} from "./markit-cache";
import { loadEmbeddedMupdfWasm } from "./mupdf-wasm-embed";

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
	cache?: MarkitConversionCacheStatus;
}

export interface MarkitFileConversionOptions {
	/**
	 * Directory the PDF converter writes extracted images/diagrams into. When
	 * set, each embedded image is rendered to `<id>.png` and referenced by path
	 * in the markdown; when unset, markit emits an `<!-- image: <id> ... -->`
	 * placeholder comment instead.
	 */
	imageDir?: string;
}

interface MuPdfWasmModuleConfig {
	print?: (...values: unknown[]) => void;
	printErr?: (...values: unknown[]) => void;
	wasmBinary?: Uint8Array;
}

function logMuPdfWasmOutput(stream: "stdout" | "stderr", values: unknown[]): void {
	const message = values.length === 1 && typeof values[0] === "string" ? values[0] : values.map(String).join(" ");
	logger.debug("mupdf wasm output", { stream, message });
}

// `$libmupdf_wasm_Module` is declared globally (as `any`) by the mupdf package.
// Install print hooks before the WASM module initializes so its stdout/stderr
// route to the file logger instead of corrupting the TUI.
function installMuPdfWasmLogger(): void {
	const moduleConfig: MuPdfWasmModuleConfig = globalThis.$libmupdf_wasm_Module ?? {};
	moduleConfig.print = (...values: unknown[]) => logMuPdfWasmOutput("stdout", values);
	moduleConfig.printErr = (...values: unknown[]) => logMuPdfWasmOutput("stderr", values);
	globalThis.$libmupdf_wasm_Module = moduleConfig;
}

// Hand the WASM module its bytes directly when the compiled binary embedded them
// (scripts/embed-mupdf-wasm.ts); a single-file binary has no node_modules for
// mupdf to read `mupdf-wasm.wasm` from. Source/npm builds get undefined here and
// mupdf loads its own wasm. Must run before the mupdf module evaluates.
function installEmbeddedMupdfWasm(): void {
	const wasmBinary = loadEmbeddedMupdfWasm();
	if (!wasmBinary) return;
	const moduleConfig: MuPdfWasmModuleConfig = globalThis.$libmupdf_wasm_Module ?? {};
	moduleConfig.wasmBinary = wasmBinary;
	globalThis.$libmupdf_wasm_Module = moduleConfig;
}

installMuPdfWasmLogger();

let markit: () => Markit | Promise<Markit> = async () => {
	// Lazy: keep the document engine (mammoth/mupdf) off the startup
	// import graph — it loads only when a document is first converted.
	installEmbeddedMupdfWasm();
	const promise = import("../markit").then(({ Markit }) => {
		const instance = new Markit();
		markit = () => instance;
		return instance;
	});
	markit = () => promise;
	return promise;
};

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	if (!trimmed) return ".bin";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}
	return "Conversion failed";
}

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	try {
		const instance = await markit();
		return signal ? await untilAborted(signal, () => task(instance)) : await task(instance);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		return { content: markdown, ok: true };
	}

	return { content: "", ok: false, error: "Conversion produced no output" };
}

function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ToolAbortError();
}

async function runCachedBufferConversion(
	bytes: Uint8Array,
	streamInfo: StreamInfo,
	signal?: AbortSignal,
	cacheEnabled = true,
): Promise<MarkitConversionResult> {
	const cacheKey = cacheEnabled
		? markitConversionCacheKey(bytes, streamInfo.extension ?? streamInfo.mimetype ?? ".bin")
		: undefined;

	if (cacheKey) {
		throwIfAborted(signal);
		const cached = await readMarkitConversionCache(cacheKey);
		throwIfAborted(signal);
		if (cached.status === "hit") {
			return { content: cached.content, ok: true, cache: "hit" };
		}
	}

	throwIfAborted(signal);
	let result: ConversionResult;
	try {
		result = await runMarkitConversion(markit => markit.convert(toBuffer(bytes), streamInfo), signal);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: normalizeError(error), cache: cacheEnabled ? "miss" : "skipped" };
	}

	const finalized = finalizeConversion(result.markdown);
	if (finalized.ok && cacheKey) {
		await writeMarkitConversionCache(cacheKey, finalized.content);
	}
	return { ...finalized, cache: cacheEnabled ? "miss" : "skipped" };
}

// ── Docling 透明接管 ──
// 如果设置了 DOCLING_SERVICE_URL 环境变量，优先通过 HTTP 调用 docling-serve
// 进行文档转换（支持更精准的 PDF 布局分析、表格识别、OCR）。
// 失败时安全回退到本地 markit（mupdf-wasm + mammoth）。
const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL;

async function tryDoclingServe(
	filePath: string,
	signal?: AbortSignal,
): Promise<MarkitConversionResult | null> {
	if (!DOCLING_SERVICE_URL) return null;
	try {
		const { createReadStream } = await import("node:fs");
		const stat = await import("node:fs/promises").then(m => m.stat(filePath));
		const fileName = path.basename(filePath);

		const formData = new FormData();
		const fileBuffer = await import("node:fs/promises").then(m => m.readFile(filePath));
		formData.append("files", new Blob([fileBuffer]), fileName);

		const url = `${DOCLING_SERVICE_URL.replace(/\/$/, "")}/api/v1/convert/file`;
		logger.debug("docling serve convert", { url, fileName, size: stat.size });

		const response = await fetch(url, {
			method: "POST",
			body: formData,
			signal,
		});

		if (!response.ok) {
			logger.debug("docling serve http error", { status: response.status });
			return null;
		}

		const data = await response.json() as { markdown?: string; document?: { md_content?: string } };
		const markdown = data.markdown ?? data.document?.md_content ?? "";
		if (markdown.length > 0) {
			logger.debug("docling serve success", { length: markdown.length });
			return { content: markdown, ok: true, cache: "skipped" };
		}
		return null;
	} catch (error) {
		logger.debug("docling serve fallback", { error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

export async function convertFileWithMarkit(
	filePath: string,
	signal?: AbortSignal,
	options?: MarkitFileConversionOptions,
): Promise<MarkitConversionResult> {
	// Docling 透明接管：优先尝试 docling-serve，失败回退到 markit
	if (!options?.imageDir) {
		const doclingResult = await tryDoclingServe(filePath, signal);
		if (doclingResult) return doclingResult;
	}

	if (options?.imageDir) {
		// Image extraction writes files into imageDir as a side effect; a
		// markdown-only cache hit would leave the directory missing members, so
		// this path stays uncached.
		try {
			const result = await runMarkitConversion(
				markit => markit.convertFile(filePath, { imageDir: options.imageDir }),
				signal,
			);
			return { ...finalizeConversion(result.markdown), cache: "skipped" };
		} catch (error) {
			if (error instanceof ToolAbortError) {
				throw error;
			}
			return { content: "", ok: false, error: normalizeError(error), cache: "skipped" };
		}
	}

	throwIfAborted(signal);
	let bytes: Uint8Array;
	try {
		bytes = await untilAborted(signal, () => Bun.file(filePath).bytes());
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
		return { content: "", ok: false, error: normalizeError(error), cache: "miss" };
	}
	const streamInfo: StreamInfo = {
		localPath: filePath,
		extension: path.extname(filePath).toLowerCase(),
		filename: path.basename(filePath),
	};
	return runCachedBufferConversion(bytes, streamInfo, signal, true);
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
	options?: { useCache?: boolean },
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: StreamInfo = {
		extension: normalizedExtension,
		filename: `input${normalizedExtension}`,
	};
	return runCachedBufferConversion(buffer, streamInfo, signal, options?.useCache ?? true);
}
