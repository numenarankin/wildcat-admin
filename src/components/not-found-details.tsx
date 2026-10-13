"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";

/**
 * The 404's actions. Client-side for one reason: `history.back()`, which is the
 * useful one — a bad address usually means the page they wanted is one step
 * behind them, not on the home screen.
 */
export function NotFoundDetails() {
  const router = useRouter();

  return (
    <div className="mt-8 flex flex-wrap justify-center gap-2">
      <button
        type="button"
        onClick={() => router.back()}
        className={buttonVariants({ variant: "outline", size: "lg" })}
      >
        Go back
      </button>
      <Link
        href="/"
        className={buttonVariants({ variant: "outline", size: "lg" })}
      >
        Home
      </Link>
      <Link
        href="/support"
        className={buttonVariants({ variant: "secondary", size: "lg" })}
      >
        Contact support
      </Link>
    </div>
  );
}
