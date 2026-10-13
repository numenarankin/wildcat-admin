import { ResetPasswordPage } from "@/components/auth/reset-password-page";

export const metadata = { title: "Reset password" };

/**
 * Landing page for an emailed reset link.
 *
 * The token is read here rather than from `window.location` in the client, so
 * the component knows on its first render whether there is a link to redeem at
 * all — a missing or malformed one is then a rendered state, not a state change
 * fired from an effect. Redemption itself still happens in the browser:
 * `verifyOtp` has to store the resulting session where the rest of the app
 * looks for it.
 */
export default async function ResetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string }>;
}) {
  const { token_hash: tokenHash, type } = await searchParams;
  return (
    <ResetPasswordPage
      tokenHash={type === "recovery" && tokenHash ? tokenHash : null}
    />
  );
}
