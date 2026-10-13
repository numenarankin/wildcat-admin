"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/theme-provider"

/**
 * App toaster. Positioned bottom-right per the in-app alerts spec. Themed via CSS
 * variables mapped to our design tokens so toasts match the app in light + dark
 * (the theme comes from the admin `ThemeProvider`, not prefers-color-scheme).
 */
function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      richColors
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
