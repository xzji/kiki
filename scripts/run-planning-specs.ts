import { runBlockProtocolSpecs } from "../src/lib/server/goalPlanning/blockProtocol.spec";
import { runTaskCompilerSpecs } from "../src/lib/server/goalPlanning/taskCompiler.spec";
import { runGoalNotificationWorkerSpecs } from "../src/lib/server/worker/goalNotificationWorker.spec";
import { runAwaitingDisplayModelSpecs } from "../src/lib/taskInstance/awaitingDisplayModel.spec";
import { runProtocolNormalizeSpecs } from "../src/lib/server/protocol/protocolNormalize.spec";
import { runPromptDuplicationGuardSpecs } from "../src/lib/planning/specs/promptDuplicationGuardSpec";
import { runRuntimeStateChannelSpecs } from "../src/lib/runtimeStateChannel.spec";

runBlockProtocolSpecs();
runTaskCompilerSpecs();
runGoalNotificationWorkerSpecs();
runAwaitingDisplayModelSpecs();
runProtocolNormalizeSpecs();
runPromptDuplicationGuardSpecs();
runRuntimeStateChannelSpecs();
console.log("planning specs passed");
