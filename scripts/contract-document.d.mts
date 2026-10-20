/**
 * The types of `contract-document.mjs`, for the TypeScript side.
 *
 * The module itself is plain ESM JavaScript, like the other scripts in this
 * directory: it is a tool, not part of the site, and the site does not
 * compile it. The declarations are here so that the tests — which are
 * TypeScript — can import it and still be type-checked.
 */

/** Every place the contract document may be, most specific first. */
export declare function contractDocumentCandidates(): string[];

/** The path of the contract document, or a clear error. */
export declare function resolveContractDocumentPath(): string;

/** The contract document, read from disk. */
export declare function loadContractDocument(): string;
