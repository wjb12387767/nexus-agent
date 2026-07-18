// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/child_net.rs）。Nexus Agent 在此基础上重写，仅做名称空间
// 与版权声明的调整，逻辑与原版一致——seccomp BPF 网络隔离是非平台特定的
// Linux 内核功能。
//
//! 每子进程的 seccomp 网络过滤器。非 Linux 上为 no-op。

/// 安装阻断网络系统调用的 seccomp BPF 过滤器。
///
/// # Safety
///
/// 必须在 `pre_exec` 上下文中调用（fork 之后、exec 之前）。
#[cfg(target_os = "linux")]
pub unsafe fn install_child_network_filter() -> std::io::Result<()> {
    use libc::{
        BPF_ABS, BPF_JEQ, BPF_JMP, BPF_K, BPF_LD, BPF_RET, BPF_W, PR_SET_NO_NEW_PRIVS,
        PR_SET_SECCOMP, SECCOMP_MODE_FILTER, SYS_accept, SYS_accept4, SYS_bind, SYS_connect,
        SYS_listen, SYS_sendmsg, SYS_sendto, prctl, sock_filter, sock_fprog,
    };

    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const EPERM_VAL: u32 = 1; // libc::EPERM

    macro_rules! bpf_stmt {
        ($code:expr, $k:expr) => {
            sock_filter {
                code: $code as u16,
                jt: 0,
                jf: 0,
                k: $k as u32,
            }
        };
    }

    macro_rules! bpf_jump {
        ($code:expr, $k:expr, $jt:expr, $jf:expr) => {
            sock_filter {
                code: $code as u16,
                jt: $jt,
                jf: $jf,
                k: $k as u32,
            }
        };
    }

    const NR_OFFSET: u32 = 0; // seccomp_data.nr 偏移

    let blocked_syscalls: &[i64] = &[
        SYS_connect,
        SYS_bind,
        SYS_sendto,
        SYS_sendmsg,
        SYS_listen,
        SYS_accept,
        SYS_accept4,
    ];

    let mut filter: Vec<sock_filter> = Vec::new();
    let total_checks = blocked_syscalls.len();

    // 1. 加载系统调用号
    filter.push(bpf_stmt!(BPF_LD | BPF_W | BPF_ABS, NR_OFFSET));

    // 2. 检查每个被阻断的系统调用
    for (i, &syscall) in blocked_syscalls.iter().enumerate() {
        let remaining = total_checks - i - 1;
        filter.push(bpf_jump!(
            BPF_JMP | BPF_JEQ | BPF_K,
            syscall,
            remaining as u8 + 1, // 命中：跳到 ERRNO
            0                    // 未命中：检查下一个
        ));
    }

    // 3. 默认：ALLOW
    filter.push(bpf_stmt!(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

    // 4. 被阻断：ERRNO(EPERM)
    filter.push(bpf_stmt!(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM_VAL));

    let prog = sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };

    // 在应用 seccomp 过滤器之前必须设置 PR_SET_NO_NEW_PRIVS
    // SAFETY: prctl with PR_SET_NO_NEW_PRIVS 在 pre_exec 上下文中是安全的。
    if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: prog 是指向我们过滤器数组的合法 sock_fprog。
    if unsafe {
        prctl(
            PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER as libc::c_ulong,
            &prog as *const _ as libc::c_ulong,
            0,
            0,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }

    Ok(())
}

/// # Safety
///
/// 非 Linux 上为 no-op。
#[cfg(not(target_os = "linux"))]
pub unsafe fn install_child_network_filter() -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_child_network_filter_is_noop_off_linux() {
        // 非 Linux 平台上必须是 no-op（Windows 走 pi-iso 降级，macOS 走 Seatbelt）。
        // 我们不能在 Linux 单元测试中真正调用它（会影响整个进程的 seccomp 状态），
        // 仅断言非 Linux 的 stub 行为。
        #[cfg(not(target_os = "linux"))]
        {
            // SAFETY: no-op 实现，仅返回 Ok(())。
            let result = unsafe { install_child_network_filter() };
            assert!(result.is_ok(), "非 Linux stub 必须返回 Ok(())");
        }
        #[cfg(target_os = "linux")]
        {
            // Linux 上：仅断言函数存在并可被引用（不实际调用以免污染测试进程）。
            let _f: unsafe fn() -> std::io::Result<()> = install_child_network_filter;
        }
    }
}
