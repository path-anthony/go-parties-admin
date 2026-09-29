-- GO's authorized signer, for the second signature block on signed
-- contracts. Both empty until set in Settings.
ALTER TABLE "accounts" ADD COLUMN     "authorized_signer_name" TEXT,
ADD COLUMN     "authorized_signer_title" TEXT;
