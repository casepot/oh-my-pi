/**
 * Bundled rules shipped with the coding agent.
 *
 * Each markdown source is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose rule files; only
 * the embedded text). Global rules are registered by the low-priority
 * `builtin-defaults` provider; project-gated packs are attached by built-in
 * skillsets and enter the same rule bucketing funnel.
 */
import rsAsyncStdFs from "./rs-async-std-fs.md" with { type: "text" };
import rsAsyncStdMpsc from "./rs-async-std-mpsc.md" with { type: "text" };
import rsBoxLeak from "./rs-box-leak.md" with { type: "text" };
import rsCfgTestModule from "./rs-cfg-test-module.md" with { type: "text" };
import rsCollectToLen from "./rs-collect-to-len.md" with { type: "text" };
import rsEmptyErrHandler from "./rs-empty-err-handler.md" with { type: "text" };
import rsErrorSourceChain from "./rs-error-source-chain.md" with { type: "text" };
import rsFormatLiteral from "./rs-format-literal.md" with { type: "text" };
import rsFromNotInto from "./rs-from-not-into.md" with { type: "text" };
import rsFuturePrelude from "./rs-future-prelude.md" with { type: "text" };
import rsLazylock from "./rs-lazylock.md" with { type: "text" };
import rsLockAcrossAwait from "./rs-lock-across-await.md" with { type: "text" };
import rsMatchErgonomics from "./rs-match-ergonomics.md" with { type: "text" };
import rsParkingLot from "./rs-parking-lot.md" with { type: "text" };
import rsPtrArgOwned from "./rs-ptr-arg-owned.md" with { type: "text" };
import rsPushFormat from "./rs-push-format.md" with { type: "text" };
import rsResultType from "./rs-result-type.md" with { type: "text" };
import rsThreadSleepInAsync from "./rs-thread-sleep-in-async.md" with { type: "text" };
import rsTokioAsyncTest from "./rs-tokio-async-test.md" with { type: "text" };
import rsUnboundedChannel from "./rs-unbounded-channel.md" with { type: "text" };
import rsUnsafeSafetyComment from "./rs-unsafe-safety-comment.md" with { type: "text" };
import tsBareCatch from "./ts-bare-catch.md" with { type: "text" };
import tsImportType from "./ts-import-type.md" with { type: "text" };
import tsNoAny from "./ts-no-any.md" with { type: "text" };
import tsNoDeprecatedLeftovers from "./ts-no-deprecated-leftovers.md" with { type: "text" };
import tsNoDynamicImport from "./ts-no-dynamic-import.md" with { type: "text" };
import tsNoInlineCastAccess from "./ts-no-inline-cast-access.md" with { type: "text" };
import tsNoReturnType from "./ts-no-return-type.md" with { type: "text" };
import tsNoTestTimers from "./ts-no-test-timers.md" with { type: "text" };
import tsNoTinyFunctions from "./ts-no-tiny-functions.md" with { type: "text" };
import tsPromiseWithResolvers from "./ts-promise-with-resolvers.md" with { type: "text" };
import tsRedundantClearGuard from "./ts-redundant-clear-guard.md" with { type: "text" };
import tsSetMap from "./ts-set-map.md" with { type: "text" };

export type BuiltinRulePack = "global" | "skillset:rust";

/** A bundled rule's stable name, raw markdown, and activation pack. */
export interface BuiltinRuleSource {
	name: string;
	content: string;
	pack: BuiltinRulePack;
}

/** All embedded rule sources, ordered by pack then name. */
export const BUILTIN_RULE_SOURCES: readonly BuiltinRuleSource[] = [
	{ name: "ts-bare-catch", content: tsBareCatch, pack: "global" },
	{ name: "ts-import-type", content: tsImportType, pack: "global" },
	{ name: "ts-no-any", content: tsNoAny, pack: "global" },
	{ name: "ts-no-deprecated-leftovers", content: tsNoDeprecatedLeftovers, pack: "global" },
	{ name: "ts-no-dynamic-import", content: tsNoDynamicImport, pack: "global" },
	{ name: "ts-no-inline-cast-access", content: tsNoInlineCastAccess, pack: "global" },
	{ name: "ts-no-return-type", content: tsNoReturnType, pack: "global" },
	{ name: "ts-no-test-timers", content: tsNoTestTimers, pack: "global" },
	{ name: "ts-no-tiny-functions", content: tsNoTinyFunctions, pack: "global" },
	{ name: "ts-promise-with-resolvers", content: tsPromiseWithResolvers, pack: "global" },
	{ name: "ts-redundant-clear-guard", content: tsRedundantClearGuard, pack: "global" },
	{ name: "ts-set-map", content: tsSetMap, pack: "global" },
	{ name: "rs-async-std-fs", content: rsAsyncStdFs, pack: "skillset:rust" },
	{ name: "rs-async-std-mpsc", content: rsAsyncStdMpsc, pack: "skillset:rust" },
	{ name: "rs-box-leak", content: rsBoxLeak, pack: "skillset:rust" },
	{ name: "rs-cfg-test-module", content: rsCfgTestModule, pack: "skillset:rust" },
	{ name: "rs-collect-to-len", content: rsCollectToLen, pack: "skillset:rust" },
	{ name: "rs-empty-err-handler", content: rsEmptyErrHandler, pack: "skillset:rust" },
	{ name: "rs-error-source-chain", content: rsErrorSourceChain, pack: "skillset:rust" },
	{ name: "rs-format-literal", content: rsFormatLiteral, pack: "skillset:rust" },
	{ name: "rs-from-not-into", content: rsFromNotInto, pack: "skillset:rust" },
	{ name: "rs-future-prelude", content: rsFuturePrelude, pack: "skillset:rust" },
	{ name: "rs-lazylock", content: rsLazylock, pack: "skillset:rust" },
	{ name: "rs-lock-across-await", content: rsLockAcrossAwait, pack: "skillset:rust" },
	{ name: "rs-match-ergonomics", content: rsMatchErgonomics, pack: "skillset:rust" },
	{ name: "rs-parking-lot", content: rsParkingLot, pack: "skillset:rust" },
	{ name: "rs-ptr-arg-owned", content: rsPtrArgOwned, pack: "skillset:rust" },
	{ name: "rs-push-format", content: rsPushFormat, pack: "skillset:rust" },
	{ name: "rs-result-type", content: rsResultType, pack: "skillset:rust" },
	{ name: "rs-thread-sleep-in-async", content: rsThreadSleepInAsync, pack: "skillset:rust" },
	{ name: "rs-tokio-async-test", content: rsTokioAsyncTest, pack: "skillset:rust" },
	{ name: "rs-unbounded-channel", content: rsUnboundedChannel, pack: "skillset:rust" },
	{ name: "rs-unsafe-safety-comment", content: rsUnsafeSafetyComment, pack: "skillset:rust" },
];

export function getBuiltinRuleSourcesForPack(pack: BuiltinRulePack): readonly BuiltinRuleSource[] {
	return BUILTIN_RULE_SOURCES.filter(source => source.pack === pack);
}
