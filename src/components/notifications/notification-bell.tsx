"use client";

import { useState } from "react";
import { wildcatAppUrl } from "@/lib/wildcat-app-url";
import { BellIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications } from "@/components/notifications/notifications-provider";
import { buildInApp } from "@/lib/notifications/in-app";
import type { NotificationRow } from "@/lib/notifications/recent";

/**
 * Header bell: unread badge + a popover listing the recent in-app alerts. Reads
 * everything from NotificationsProvider. Opening the panel does not auto-clear;
 * "Mark all read" and clicking a row do.
 */
export function NotificationBell() {
  const { items, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  function handleRowClick(row: NotificationRow) {
    const info = buildInApp(row.type, row.payload);
    markRead(row.id);
    if (info?.href) {
      setOpen(false);
      // Every notification names a page in the customer app.
      window.location.assign(wildcatAppUrl(info.href));
    }
  }

  const badge = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={
              unreadCount > 0
                ? `Alerts, ${unreadCount} unread`
                : "Alerts"
            }
          />
        }
      >
        <span className="relative inline-flex">
          <BellIcon />
          {unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground">
              {badge}
            </span>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Mark all read
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            You&apos;re all caught up.
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="divide-y">
              {items.map((row) => {
                const info = buildInApp(row.type, row.payload);
                if (!info) return null;
                const unread = !row.read_at;
                const clickable = Boolean(info.href);
                return (
                  <li key={row.id}>
                    <div
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => handleRowClick(row) : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleRowClick(row);
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        "flex gap-2.5 px-4 py-3 text-sm transition-colors",
                        clickable && "cursor-pointer hover:bg-accent/50",
                        unread && "bg-primary/[0.04]"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-2 shrink-0 rounded-full",
                          unread ? "bg-primary" : "bg-transparent"
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{info.title}</p>
                        {info.body && (
                          <p className="mt-0.5 truncate text-muted-foreground">
                            {info.body}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground/70">
                          {formatDistanceToNow(new Date(row.created_at), {
                            addSuffix: true,
                          })}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
