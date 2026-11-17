export const SUPPORTED_NETWORKS = ["giwa", "ethereum"] as const;

export type Network = (typeof SUPPORTED_NETWORKS)[number];
