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
import { SlackGlyph } from "@/components/admin/slack/slack-glyph";
import { disconnectSlack } from "@/lib/admin/slack/actions";
import type { SlackSettings } from "@/lib/admin/slack/settings";

/**
 * Admin Settings > Connections: the caller's own Slack account, under Google.
 * `GoogleSection` with one row instead of four: Slack grants everything the
 * Slack page needs in one consent.
 */

// Same value as SLACK_POPUP.source in lib/admin/slack/popup.ts (server only).
const POPUP_MESSAGE = "wildcat-admin-slack-oauth";
const CONNECT_HREF = "/api/admin/slack/connect?popup=1";

const SLACK_ERRORS: Record<string, string> = {
  denied: "Slack access was not granted.",
  state: "The connection attempt expired or did not match your session. Try again.",
  exchange: "Slack did not complete the connection. Try again.",
  scope: "Slack access was granted without every permission the Slack page needs. Try again.",
  config: "Slack isn't configured on this server.",
  account: "That's a different Slack account or workspace. Disconnect the current one first.",
};

export function SlackSection({
  settings,
  slackError,
}: {
  /** Null when the connection could not be read. */
  settings: SlackSettings | null;
  slackError?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(
    slackError ? (SLACK_ERRORS[slackError] ?? SLACK_ERRORS.exchange) : null
  );
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  /** Straight from the click, so popup blockers count it as user-initiated. */
  function openConnect() {
    setError(null);
    const win = window.open(CONNECT_HREF, "wildcat-admin-slack", "width=520,height=720,menubar=no,toolbar=no");
    if (!win) {
      // Blocked: the full-page round trip still works.
      window.location.assign(CONNECT_HREF);
      return;
    }
    setConnecting(true);
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; error?: string | null } | null;
      if (!data || data.source !== POPUP_MESSAGE) return;
      setConnecting(false);
      if (data.error) {
        setError(SLACK_ERRORS[data.error] ?? SLACK_ERRORS.exchange);
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
        const result = await disconnectSlack();
        if (!result.ok) setError(result.error);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't disconnect Slack.");
      }
    });
  }

  if (!settings) {
    return (
      <SettingsPanel>
        <SettingsMessage error="Couldn't load your Slack connection." />
      </SettingsPanel>
    );
  }

  const { configured, connected, needsReauth, hasScopes, teamName } = settings;
  const showConnect = !connected || needsReauth || !hasScopes;

  return (
    <SettingsPanel
      action={
        connected ? (
          <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={() => setConfirmDisconnect(true)}>
            {pending && <Loader2Icon className="animate-spin" />}
            Disconnect Slack
          </Button>
        ) : undefined
      }
    >
      <SettingsMessage
        error={
          error ??
          (!configured
            ? SLACK_ERRORS.config
            : needsReauth
              ? "Slack needs to be reconnected."
              : connected && !hasScopes
                ? "Slack is missing a permission the Slack page needs. Reconnect it."
                : null)
        }
      />

      <SettingsTable
        head={
          <>
            <TableHead>Service</TableHead>
            <TableHead>Workspace</TableHead>
            <TableHead className="text-right" />
          </>
        }
      >
        <SettingsRow>
          <TableCell className="font-medium">
            <span className="inline-flex items-center gap-2">
              <SlackGlyph />
              Slack
            </span>
          </TableCell>
          <TableCell className={connected ? undefined : "text-muted-foreground"}>
            {connected ? (teamName ?? "Connected") : "Not connected"}
          </TableCell>
          <TableCell className="text-right">
            <div className="flex justify-end">
              {showConnect ? (
                <Button type="button" size="lg" disabled={!configured || connecting || pending} onClick={openConnect}>
                  {connecting && <Loader2Icon className="animate-spin" />}
                  {connected ? "Reconnect" : "Connect"}
                </Button>
              ) : (
                <SettingsChip tone="primary">Connected</SettingsChip>
              )}
            </div>
          </TableCell>
        </SettingsRow>
      </SettingsTable>

      <ConfirmModal
        open={confirmDisconnect}
        title="Disconnect Slack?"
        description="Nothing is deleted from Slack."
        body={
          <>
            The Slack page stops working for{" "}
            <span className="font-medium text-foreground">{teamName ?? "this workspace"}</span>. You can connect again
            any time.
          </>
        }
        confirmLabel="Disconnect Slack"
        onConfirm={disconnect}
        onClose={() => setConfirmDisconnect(false)}
      />
    </SettingsPanel>
  );
}
