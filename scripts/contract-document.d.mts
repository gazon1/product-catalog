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

/** The pin file: where the storefront says which crawler image it talks to. */
export declare function pinFilePath(root?: string): string;

/** The crawler commit the pin names, or null when the pin names none. */
export declare function pinnedCrawlerCommit(pinFile?: string): string | null;
