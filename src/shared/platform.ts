export type PlatformTriple =
  | "windows-x64"
  | "windows-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "macos-x64"
  | "macos-arm64";

export interface HostPlatform {
  /** Canonical manifest target id (used for uv asset + lockfile lookup). */
  target: PlatformTriple;
  /** uv pip --python-platform value for lock-time resolution. */
  lockPlatform: string;
  /** True when running on Windows. */
  isWindows: boolean;
  /** Unsupported-but-running marker (linux musl, 32-bit, unknown). */
  supported: boolean;
  /** Machine-readable reason when supported === false. */
  unsupportedReason?: string;
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HostPlatform {
  // Parameters keep the support matrix deterministic in tests; defaults use the host.

  if (platform === "win32") {
    if (arch === "x64")
      return {
        target: "windows-x64",
        lockPlatform: "x86_64-pc-windows-msvc",
        isWindows: true,
        supported: true,
      };
    if (arch === "arm64")
      return {
        target: "windows-arm64",
        lockPlatform: "aarch64-pc-windows-msvc",
        isWindows: true,
        supported: true,
      };
    return {
      target: "windows-x64",
      lockPlatform: "x86_64-pc-windows-msvc",
      isWindows: true,
      supported: false,
      unsupportedReason: `windows-${arch}: no supported uv/Python wheel set; run 64-bit OMP`,
    };
  }
  if (platform === "linux") {
    if (arch === "x64")
      return {
        target: "linux-x64",
        lockPlatform: "x86_64-unknown-linux-gnu",
        isWindows: false,
        supported: true,
      };
    if (arch === "arm64")
      return {
        target: "linux-arm64",
        lockPlatform: "aarch64-unknown-linux-gnu",
        isWindows: false,
        supported: true,
      };
    return {
      target: "linux-x64",
      lockPlatform: "x86_64-unknown-linux-gnu",
      isWindows: false,
      supported: false,
      unsupportedReason: `linux-${arch}: glibc x64/arm64 only; musl and 32-bit unsupported`,
    };
  }
  if (platform === "darwin") {
    if (arch === "x64")
      return {
        target: "macos-x64",
        lockPlatform: "x86_64-apple-darwin",
        isWindows: false,
        supported: true,
      };
    if (arch === "arm64")
      return {
        target: "macos-arm64",
        lockPlatform: "aarch64-apple-darwin",
        isWindows: false,
        supported: true,
      };
    return {
      target: "macos-arm64",
      lockPlatform: "aarch64-apple-darwin",
      isWindows: false,
      supported: false,
      unsupportedReason: `macos-${arch}: x64/arm64 only`,
    };
  }
  return {
    target: "linux-x64",
    lockPlatform: "x86_64-unknown-linux-gnu",
    isWindows: false,
    supported: false,
    unsupportedReason: `platform ${platform}/${arch} unsupported`,
  };
}
