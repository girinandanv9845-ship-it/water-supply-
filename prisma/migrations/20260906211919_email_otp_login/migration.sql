-- Email OTP login.
--
-- OtpChallenge.phone becomes a generic `identifier` (phone number or email)
-- with a `channel` discriminator. Done as a RENAME rather than drop+add so
-- outstanding login codes survive the deploy.

-- 1. A customer may now sign up with an email instead of a phone.
ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;

-- 2. Delivery channel for a code.
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'EMAIL');

-- 3. Generalise the identifier, preserving existing rows.
ALTER TABLE "OtpChallenge" RENAME COLUMN "phone" TO "identifier";
ALTER TABLE "OtpChallenge" ADD COLUMN "channel" "OtpChannel" NOT NULL DEFAULT 'SMS';

-- 4. Re-point the lookup index at the renamed column.
DROP INDEX IF EXISTS "OtpChallenge_phone_expiresAt_idx";
CREATE INDEX "OtpChallenge_identifier_expiresAt_idx" ON "OtpChallenge"("identifier", "expiresAt");
