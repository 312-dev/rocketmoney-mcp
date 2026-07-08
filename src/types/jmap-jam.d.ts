// Minimal type shim for jmap-jam. The published package exposes raw .ts source
// (through jmap-rfc-types) whose `.ts`-suffixed imports don't compile under this
// project's NodeNext settings. tsconfig `paths` maps "jmap-jam" here for
// type-checking only; at runtime Node resolves the real package. We only use the
// three members below (email.ts treats results loosely).
export class JamClient {
  constructor(opts: { bearerToken: string; sessionUrl: string });
  getPrimaryAccount(): Promise<string>;
  request(call: unknown): Promise<unknown[]>;
}
