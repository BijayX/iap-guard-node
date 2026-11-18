/** Source of "now" for every time comparison (SPEC §12). Inject a fixed clock in tests. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
