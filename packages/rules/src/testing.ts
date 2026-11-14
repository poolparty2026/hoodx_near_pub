/** **Tests only.** Builds a record without the `evaluate` check, to make one that lies, which the page must refuse. Apps must never import this (a test greps for it). */
export { decisionRecordTextUnchecked } from "./decision.ts";
