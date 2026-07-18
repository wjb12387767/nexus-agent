// SPDX-License-Identifier: Apache-2.0
// Nexus Agent 改编：NAPI 构建脚本，告诉 napi-rs 在构建时输出 .d.ts 类型声明。
fn main() {
    napi_build::setup();
}
