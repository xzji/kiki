import { runBlockProtocolSpecs } from "../src/lib/server/goalPlanning/blockProtocol.spec";
import { runTaskCompilerSpecs } from "../src/lib/server/goalPlanning/taskCompiler.spec";
import { runAwaitingDisplayModelSpecs } from "../src/lib/taskInstance/awaitingDisplayModel.spec";

runBlockProtocolSpecs();
runTaskCompilerSpecs();
runAwaitingDisplayModelSpecs();
console.log("planning specs passed");
