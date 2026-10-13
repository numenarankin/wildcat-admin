import Link from "next/link";

/** A Google page whose service is not connected: says which, links to Connections. */
export function GoogleNotConnected({ title, service }: { title: string; service: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">
        Google {service} isn&apos;t connected.{" "}
        <Link href="/settings?section=connections" className="text-foreground underline underline-offset-4">
          Connect it in Settings
        </Link>
        .
      </p>
    </div>
  );
}
