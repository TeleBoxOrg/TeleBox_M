import { execFileSync } from "child_process";
import path from "path";
import { logger } from "@utils/logger";
import { getExecErrorOutput } from "@utils/errorHelpers";

function buildCleanNpmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // 当前进程若由 npm 启动，会携带大量 npm_* 环境变量。
  // 其中 workspace / argv 等参数在子 npm 进程里可能被错误继承，
  // 造成类似 “No workspaces found: --workspace=--loglevel” 的噪音报错。
  for (const key of Object.keys(env)) {
    if (/^npm_(config_|package_|lifecycle_|command)/i.test(key)) {
      delete env[key];
    }
  }

  return env;
}

function runNpm(args: string[]): void {
  execFileSync(
    "npm",
    [...args, "--no-fund", "--no-audit", "--loglevel=error"],
    {
      cwd: path.resolve(process.cwd()),
      env: buildCleanNpmEnv(),
      stdio: "pipe",
      encoding: "utf-8",
    }
  );
}

/**
 * npm_install - 安装指定的 npm 包
 * @param pkg 包名
 * @param version 版本号（可选）
 */
export function npm_install(pkg: string, version?: string) {
  const fullName = version ? `${pkg}@${version}` : pkg;

  try {
    require.resolve(pkg);
    logger.info(`Package "${pkg}" is already installed.`);
  } catch (e) {
    logger.info(`Installing ${fullName}...`);
    try {
      runNpm(["install", fullName]);
      logger.info(`Package "${fullName}" installed successfully.`);
    } catch (error: unknown) {
      const { stderr, message } = getExecErrorOutput(error);
      const errMsg = stderr || message || String(error);
      logger.error(`Failed to install ${fullName}: ${errMsg}`);
      throw error;
    }
  }
}

export function npm_install_project_dependencies() {
  logger.info("Installing project dependencies...");
  try {
    runNpm(["install"]);
    logger.info("Project dependencies installed successfully.");
  } catch (error: unknown) {
    const { stderr, message } = getExecErrorOutput(error);
    const errMsg = stderr || message || String(error);
    logger.error(`Failed to install project dependencies: ${errMsg}`);
    throw error;
  }
}
