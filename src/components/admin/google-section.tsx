"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead } from "@/components/ui/table";
import {
  ConfirmModal,
  SettingsChip,
  SettingsMessage,
  SettingsPanel,
  SettingsRow,
  SettingsTable,
} from "@/components/settings/panel";
import { disconnectGoogle } from "@/lib/admin/google/actions";
import type { GoogleSettings } from "@/lib/admin/google/settings";
import type { GoogleService } from "@/lib/admin/google/oauth";

/**
 * Admin Settings > Connections: the caller's own Google account, granted one
 * service at a time. The customer Settings > Files Dropbox row's shape and
 * popup round trip; Google's incremental authorization means each Connect adds
 * a service to the same grant, and Disconnect revokes all of them.
 */

// Same value as GOOGLE_POPUP_MESSAGE in lib/admin/google/popup.ts (server only).
const POPUP_MESSAGE = "wildcat-admin-google-oauth";

const SERVICES: ReadonlyArray<{ id: GoogleService; label: string }> = [
  { id: "gmail", label: "Email" },
  { id: "calendar", label: "Calendar" },
  { id: "tasks", label: "Tasks" },
  { id: "drive", label: "Drive" },
];

const GOOGLE_ERRORS: Record<string, string> = {
  denied: "Google access was not granted.",
  state: "The connection attempt expired or did not match your session. Try again.",
  exchange: "Google did not complete the connection. Try again.",
  scope: "Google access was granted without that service. Try again and leave its box ticked.",
  config: "Google isn't configured on this server.",
  service: "Unknown Google service.",
  account: "That's a different Google account. Disconnect the current one first.",
};

function connectHref(service: GoogleService): string {
  return `/api/admin/google/connect?service=${service}&popup=1`;
}

/** Google's "G", per their branding guide. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.92l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.27a12 12 0 0 0 0 10.76l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.27 6.62l4.01 3.1C6.22 6.88 8.87 4.77 12 4.77z" />
    </svg>
  );
}

export function GoogleSection({
  settings,
  googleError,
}: {
  /** Null when the connection could not be read. */
  settings: GoogleSettings | null;
  googleError?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(
    googleError ? (GOOGLE_ERRORS[googleError] ?? GOOGLE_ERRORS.exchange) : null
  );
  const [connecting, setConnecting] = useState<GoogleService | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  /** Straight from the click, so popup blockers count it as user-initiated. */
  function openConnect(service: GoogleService) {
    setError(null);
    const href = connectHref(service);
    const win = window.open(href, "wildcat-admin-google", "width=520,height=720,menubar=no,toolbar=no");
    if (!win) {
      // Blocked: the full-page round trip still works. A document navigation,
      // since the target answers with a redirect to Google.
      window.location.assign(href);
      return;
    }
    setConnecting(service);
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; error?: string | null } | null;
      if (!data || data.source !== POPUP_MESSAGE) return;
      setConnecting(null);
      if (data.error) {
        setError(GOOGLE_ERRORS[data.error] ?? GOOGLE_ERRORS.exchange);
        return;
      }
      setError(null);
      router.refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  function disconnect() {
    setConfirmDisconnect(false);
    setError(null);
    startTransition(async () => {
      try {
        const result = await disconnectGoogle();
        if (!result.ok) setError(result.error);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't disconnect Google.");
      }
    });
  }

  if (!settings) {
    return (
      <SettingsPanel>
        <SettingsMessage error="Couldn't load your Google connection." />
      </SettingsPanel>
    );
  }

  const { configured, connected, needsReauth, accountEmail, services } = settings;

  return (
    <SettingsPanel
      action={
        connected ? (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={pending}
            onClick={() => setConfirmDisconnect(true)}
          >
            {pending && <Loader2Icon className="animate-spin" />}
            Disconnect Google
          </Button>
        ) : undefined
      }
    >
      <SettingsMessage
        error={
          error ??
          (!configured ? GOOGLE_ERRORS.config : needsReauth ? "Google needs to be reconnected." : null)
        }
      />

      <SettingsTable
        head={
          <>
            <TableHead>Service</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right" />
          </>
        }
      >
        {SERVICES.map(({ id, label }) => {
          const on = services.includes(id);
          const showConnect = !on || needsReauth;
          return (
            <SettingsRow key={id}>
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-2">
                  <GoogleGlyph />
                  {label}
                </span>
              </TableCell>
              <TableCell className={on ? undefined : "text-muted-foreground"}>
                {on ? (accountEmail ?? "Connected") : "Not connected"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end">
                  {showConnect ? (
                    <Button
                      type="button"
                      size="lg"
                      disabled={!configured || connecting !== null || pending}
                      onClick={() => openConnect(id)}
                    >
                      {connecting === id && <Loader2Icon className="animate-spin" />}
                      {on ? "Reconnect" : "Connect"}
                    </Button>
                  ) : (
                    <SettingsChip tone="primary">Connected</SettingsChip>
                  )}
                </div>
              </TableCell>
            </SettingsRow>
          );
        })}
      </SettingsTable>

      <ConfirmModal
        open={confirmDisconnect}
        title="Disconnect Google?"
        description="Nothing is deleted from Google."
        body={
          <>
            Email, Calendar, Tasks and Drive for{" "}
            <span className="font-medium text-foreground">{accountEmail ?? "this account"}</span>{" "}
            all disconnect. You can connect again any time.
          </>
        }
        confirmLabel="Disconnect Google"
        onConfirm={disconnect}
        onClose={() => setConfirmDisconnect(false)}
      />
    </SettingsPanel>
  );
}
