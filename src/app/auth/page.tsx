import { AuthPage } from "@/components/auth/auth-page";

export const metadata = { title: "Sign in" };

export default async function Auth({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  // `?mode=forgot` is where a spent reset link sends people.
  return <AuthPage initialMode={mode === "forgot" ? "forgot" : undefined} />;
}
