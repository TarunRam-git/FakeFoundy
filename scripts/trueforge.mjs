import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Use TrueForge's native per-provider-request retries. Never replay a whole
// session, tool call, or proposal in order to retry a rate-limited model request.
export function runtimeEnvironment(env) {
  const raw = env.MODEL_HTTP_MAX_RETRIES ?? "7";
  if (!/^[0-8]$/.test(raw))
    throw new Error("MODEL_HTTP_MAX_RETRIES must be an integer from 0 to 8");
  return { ...env, MODEL_HTTP_MAX_RETRIES: raw };
}
export function startRuntime(args = process.argv.slice(2), env = process.env) {
  const configured = runtimeEnvironment(env);
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("@truefoundry/trueforge/package.json")), "dist", "cli.js");
  const child = spawn(process.execPath, [cli, ...args], { env: configured, stdio: "inherit", shell: false });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);
  const cleanup = () => {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTerminate);
  };
  child.once("error", error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { cleanup(); process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
  return child;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startRuntime(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
