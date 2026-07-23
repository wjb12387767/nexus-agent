#!/bin/bash

# Nexus WorkAny One-Click Build Script
#
# Builds the WorkAny desktop app bundled with the nexus-agent CLI as a sidecar.
# The nexus-agent is a Bun project that cannot be packaged with pkg; instead we
# compile it with `bun build --compile` and ship the resulting single binary as
# a Tauri sidecar (externalBin), discovered at runtime via NEXUS_CLI_FALLBACK_NAMES.
#
# Usage: ./scripts/build-nexus.sh [platform] [--with-nexus]
#   platform: current (default) | linux | windows | mac-arm | mac-intel | all
#   --with-nexus: also build the nexus-agent CLI and copy it into src-api/dist
#
# Requirements: pnpm, cargo/rustup, bun (for nexus-agent + workany-api sidecar)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables
BUILD_PLATFORM="current"
WITH_NEXUS=false

# nexus-agent repo root relative to WorkAny project (../../ from workany-dev/workany-dev)
NEXUS_REPO_ROOT="$(cd "$PROJECT_ROOT/../.." 2>/dev/null && pwd || echo "")"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# ----------------------------------------------------------------------------
# Platform helpers
# ----------------------------------------------------------------------------

# Detect the current host's Rust target triple and Bun compile target.
detect_host_target() {
    local os_name
    local arch
    os_name="$(uname -s)"
    arch="$(uname -m)"
    case "$os_name" in
        Darwin)
            if [ "$arch" = "arm64" ]; then
                echo "aarch64-apple-darwin bun-darwin-arm64 darwin-arm64"
            else
                echo "x86_64-apple-darwin bun-darwin-x64 darwin-x64"
            fi
            ;;
        Linux)
            echo "x86_64-unknown-linux-gnu bun-linux-x64 linux-x64"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "x86_64-pc-windows-msvc bun-windows-x64 win32-x64"
            ;;
        *)
            log_error "Unsupported host OS: $os_name"
            exit 1
            ;;
    esac
}

# Resolve build targets for a given platform alias.
# Echoes: "<rust_target> <bun_api_target> <nexus_cross_target>"
# nexus_cross_target is empty for "current" (native build, no CROSS_TARGET).
resolve_targets() {
    local platform="$1"
    case "$platform" in
        current)
            detect_host_target
            ;;
        linux)
            echo "x86_64-unknown-linux-gnu bun-linux-x64 linux-x64"
            ;;
        windows)
            echo "x86_64-pc-windows-msvc bun-windows-x64 win32-x64"
            ;;
        mac-arm)
            echo "aarch64-apple-darwin bun-darwin-arm64 darwin-arm64"
            ;;
        mac-intel)
            echo "x86_64-apple-darwin bun-darwin-x64 darwin-x64"
            ;;
        *)
            log_error "Unknown platform: $platform"
            exit 1
            ;;
    esac
}

# ----------------------------------------------------------------------------
# Requirement checks
# ----------------------------------------------------------------------------

check_requirements() {
    log_step "Checking requirements..."

    command -v pnpm >/dev/null 2>&1 || { log_error "pnpm is required"; exit 1; }
    command -v cargo >/dev/null 2>&1 || { log_error "cargo is required"; exit 1; }
    command -v rustup >/dev/null 2>&1 || { log_error "rustup is required"; exit 1; }
    command -v bun >/dev/null 2>&1 || { log_error "bun is required (for nexus-agent + workany-api sidecar)"; exit 1; }

    log_info "All requirements satisfied."
}

# ----------------------------------------------------------------------------
# Dependencies
# ----------------------------------------------------------------------------

install_deps() {
    log_step "Installing frontend dependencies..."
    pnpm install
}

# ----------------------------------------------------------------------------
# API sidecar (workany-api) — built with bun --compile, matching CI build.yml
# ----------------------------------------------------------------------------

build_api_sidecar() {
    local rust_target="$1"
    local bun_api_target="$2"
    log_step "Building workany-api sidecar for $rust_target..."

    cd "$PROJECT_ROOT/src-api"
    mkdir -p dist

    local out_name="workany-api-${rust_target}"
    if [ "$rust_target" = "x86_64-pc-windows-msvc" ]; then
        out_name="${out_name}.exe"
    fi

    bun build src/index.ts --compile --target="$bun_api_target" --outfile "dist/${out_name}"
    chmod +x "dist/${out_name}" 2>/dev/null || true

    cd "$PROJECT_ROOT"
    log_info "workany-api sidecar built: src-api/dist/${out_name}"
}

# ----------------------------------------------------------------------------
# nexus-agent CLI — built with bun --compile via coding-agent build script
# ----------------------------------------------------------------------------

bundle_nexus() {
    if [ "$WITH_NEXUS" != "true" ]; then
        log_info "Skipping nexus-agent bundling (pass --with-nexus to enable)"
        return 0
    fi

    log_step "Bundling nexus-agent CLI..."

    if [ -z "$NEXUS_REPO_ROOT" ] || [ ! -d "$NEXUS_REPO_ROOT/packages/coding-agent" ]; then
        log_warn "nexus-agent repo not found at $NEXUS_REPO_ROOT; skipping nexus CLI build"
        return 0
    fi

    local rust_target="$1"
    local nexus_cross_target="$2"
    local nexus_src_bin
    local nexus_dst_bin

    # Build the nexus CLI binary.
    # When nexus_cross_target is empty we build natively (current host).
    cd "$NEXUS_REPO_ROOT"
    if [ -n "$nexus_cross_target" ]; then
        log_info "Cross-compiling nexus CLI for $nexus_cross_target..."
        CROSS_TARGET="$nexus_cross_target" bun --cwd=packages/coding-agent run build || {
            log_warn "nexus CLI cross-build failed; falling back to native build"
            bun --cwd=packages/coding-agent run build
        }
        nexus_src_bin="packages/coding-agent/dist/nexus-${nexus_cross_target}"
    else
        log_info "Building nexus CLI for current host..."
        bun --cwd=packages/coding-agent run build || {
            log_warn "nexus CLI build failed; skipping"
            cd "$PROJECT_ROOT"
            return 0
        }
        nexus_src_bin="packages/coding-agent/dist/nexus"
    fi

    cd "$PROJECT_ROOT"

    # Tauri sidecar naming: nexus-<rust_target>[.exe]
    local out_dir="$PROJECT_ROOT/src-api/dist"
    mkdir -p "$out_dir"
    nexus_dst_bin="${out_dir}/nexus-${rust_target}"
    if [ "$rust_target" = "x86_64-pc-windows-msvc" ]; then
        nexus_dst_bin="${nexus_dst_bin}.exe"
    fi

    if [ ! -f "$NEXUS_REPO_ROOT/${nexus_src_bin}" ]; then
        log_warn "nexus binary not found at $NEXUS_REPO_ROOT/${nexus_src_bin}; skipping copy"
        return 0
    fi

    cp "$NEXUS_REPO_ROOT/${nexus_src_bin}" "$nexus_dst_bin"
    chmod +x "$nexus_dst_bin" 2>/dev/null || true
    log_info "nexus CLI copied to: ${nexus_dst_bin#$PROJECT_ROOT/}"
}

# ----------------------------------------------------------------------------
# Frontend
# ----------------------------------------------------------------------------

build_frontend() {
    log_step "Building frontend..."
    pnpm build
}

# ----------------------------------------------------------------------------
# Tauri bundle
# ----------------------------------------------------------------------------

build_tauri() {
    local platform="$1"
    local rust_target="$2"
    log_step "Building Tauri app ($platform)..."

    local target_flag=""
    case "$platform" in
        current) target_flag="" ;;
        *) target_flag="--target $rust_target" ;;
    esac

    # shellcheck disable=SC2086
    pnpm tauri build $target_flag
}

# ----------------------------------------------------------------------------
# Results
# ----------------------------------------------------------------------------

show_results() {
    local rust_target="$1"
    echo ""
    echo -e "${GREEN}=== Nexus WorkAny build complete ===${NC}"
    local search_dir="src-tauri/target"
    if [ -n "$rust_target" ] && [ "$rust_target" != "current" ]; then
        search_dir="src-tauri/target/${rust_target}/release/bundle"
    fi
    find "$search_dir" -type f \( -name "*.dmg" -o -name "*.deb" -o -name "*.rpm" \
        -o -name "*.msi" -o -name "*.exe" -o -name "*.AppImage" \) 2>/dev/null | head -20 || true
}

# ----------------------------------------------------------------------------
# Single-platform build pipeline
# ----------------------------------------------------------------------------

build_platform() {
    local platform="$1"
    log_info "========== Building for platform: $platform =========="

    local targets
    targets="$(resolve_targets "$platform")"
    local rust_target bun_api_target nexus_cross_target
    rust_target="$(echo "$targets" | awk '{print $1}')"
    bun_api_target="$(echo "$targets" | awk '{print $2}')"
    nexus_cross_target="$(echo "$targets" | awk '{print $3}')"

    log_info "rust_target=$rust_target bun_api_target=$bun_api_target nexus_cross_target=${nexus_cross_target:-<native>}"

    # Ensure the Rust target is installed
    if [ "$platform" != "current" ]; then
        rustup target add "$rust_target" 2>/dev/null || true
    fi

    build_api_sidecar "$rust_target" "$bun_api_target"
    bundle_nexus "$rust_target" "$nexus_cross_target"
    build_frontend
    build_tauri "$platform" "$rust_target"
    show_results "$rust_target"
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------

parse_args() {
    BUILD_PLATFORM="current"
    WITH_NEXUS=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --with-nexus)
                WITH_NEXUS=true
                shift
                ;;
            -h|--help|help)
                echo "Nexus WorkAny Build Script"
                echo ""
                echo "Usage: ./scripts/build-nexus.sh [platform] [--with-nexus]"
                echo ""
                echo "Platforms:"
                echo "  current    Build for current host platform (default)"
                echo "  linux      Build for Linux x86_64"
                echo "  windows    Build for Windows x86_64"
                echo "  mac-arm    Build for macOS Apple Silicon (aarch64)"
                echo "  mac-intel  Build for macOS Intel (x86_64)"
                echo "  all        Build for all platforms (requires cross-compilation)"
                echo ""
                echo "Options:"
                echo "  --with-nexus  Build the nexus-agent CLI and bundle it as a sidecar"
                echo ""
                echo "Requirements: pnpm, cargo/rustup, bun"
                exit 0
                ;;
            linux|windows|mac-arm|mac-intel|current|all)
                BUILD_PLATFORM="$1"
                shift
                ;;
            *)
                log_error "Unknown argument: $1"
                exit 1
                ;;
        esac
    done
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

main() {
    parse_args "$@"

    if [ "$WITH_NEXUS" = "true" ]; then
        log_info "nexus-agent CLI bundling enabled"
    fi

    check_requirements
    install_deps

    case "$BUILD_PLATFORM" in
        all)
            log_warn "Building for all platforms requires cross-compilation setup."
            log_warn "Consider using GitHub Actions for cross-platform builds."
            build_platform linux
            build_platform windows
            build_platform mac-intel
            build_platform mac-arm
            ;;
        *)
            build_platform "$BUILD_PLATFORM"
            ;;
    esac

    log_info "Nexus WorkAny build finished."
}

main "$@"
