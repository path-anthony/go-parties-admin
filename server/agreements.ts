// The slim agreement view carried on every booking the admin sees: what was
// agreed, when, and to which version of the policy. The contract fields are
// reserved for the signed-contract integration and are empty until then.
export const AGREEMENT_SELECT = {
  select: {
    id: true,
    checkboxChecked: true,
    agreedAt: true,
    contractProvider: true,
    contractExternalId: true,
    contractStatus: true,
    contractUrl: true,
    // Block T1: the contract's format and the sign-and-pay date a tier 2
    // hold pinned.
    format: true,
    confirmByDate: true,
    contractSentAt: true,
    policyVersion: { select: { id: true, version: true } },
  },
} as const;
