import { buildEnvironmentPreflight } from "./build-env-preflight";
import type { BuildConfig } from "../types";
import { getDockerBuildRecipe, resolveRuntimeImages, assertRuntimeVersionTarget } from "@repo/core";
import { generatePhpDockerfile } from "./docker-recipes/php";
import { generateRubyDockerfile } from "./docker-recipes/ruby";
import { generateStaticDockerfile } from "./docker-recipes/static";
import { generateGenericDockerfile } from "./docker-recipes/generic";
import { normalizeDockerRootDirectory } from "./docker-paths";
import { buildEnvArgLines } from "./docker-recipes/shared";
import { shellQuote } from "@repo/core";

export {
  builderContextRoot,
  isExcludedDocRootEntry,
  staticBuilderOutputPath,
} from "./docker-recipes/static";

const recipes = {
  php: generatePhpDockerfile,
  ruby: generateRubyDockerfile,
  static: generateStaticDockerfile,
  generic: generateGenericDockerfile,
};

export function generateDockerfile(config: BuildConfig): string {
  assertRuntimeVersionTarget({
    runtimeVersion: config.runtimeVersion,
    runtimeImage: config.runtimeImageOverride ? config.runtimeImage : undefined,
    framework: config.stack,
    workloadType: config.isStatic ? "static" : "web",
    buildKind: config.dockerfilePath || config.dockerfileContent ? "dockerfile" : undefined,
  });
  if (config.runtimeVersion != null) {
    resolveRuntimeImages(
      config.stack,
      config.runtimeVersion,
      config.buildImage,
      config.runtimeImage,
    );
  }
  const root = normalizeDockerRootDirectory(config.rootDirectory, config.localPath);
  const workdir = root ? `/workspace/${root}` : "/workspace";
  const preflight = `test -d ${shellQuote(workdir)} || { echo 'Configured root directory does not exist in this revision.' >&2; exit 1; }; cd ${shellQuote(workdir)} && ${buildEnvironmentPreflight(config.envVars)}`;
  const recipe = recipes[getDockerBuildRecipe(config.stack, config.isStatic)](config)
    .replace("COPY . /workspace", `COPY . /workspace\nRUN ${preflight}`);
  // Declare every build env var as a valueless ARG in each stage, right
  // after its FROM, so the RUN lines' `export KEY="$KEY"` resolves from
  // the build args instead of an inline literal. Without the matching
  // ARG the export would expand to empty; without the ARG-after-FROM
  // placement a later stage could not see the var at all. The Dockerfile
  // then contains no secret value for BuildKit to echo into the build
  // log (openship#1663).
  const argLines = buildEnvArgLines(config.envVars);
  const withArgs = argLines.length > 0
    ? recipe.replace(/^(FROM .+)$/gm, `$1\n${argLines.join("\n")}`)
    : recipe;
  if (!config.buildCache) return withArgs;
  const cacheTargets = [...new Set([...withArgs.matchAll(/--mount=type=cache,[^\s]*target=([^,\s]+)/g)].map(match => match[1]))];
  // Automatic platform args need declaring in each stage for mount ID expansion.
  return withArgs.replace(/^(FROM .+)$/gm, "$1\nARG TARGETPLATFORM") + (cacheTargets.length ? `\nLABEL io.openship.build-cache-targets=${JSON.stringify(JSON.stringify(cacheTargets))}` : "");
}
