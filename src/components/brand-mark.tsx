import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * The WildcatIQ mark, swapped for the white cut in dark mode. Both PNGs are
 * the landing page's (`wildcatiq-landing/public`), so the brand reads the
 * same across the two sites.
 */
export function BrandMark({
  alt = "WildcatIQ logo",
  size,
  className,
}: {
  alt?: string;
  size: number;
  className?: string;
}) {
  return (
    <>
      <Image
        src="/slim_normal.png"
        alt={alt}
        width={size}
        height={size}
        className={cn("shrink-0 object-contain dark:hidden", className)}
      />
      <Image
        src="/slim_normal_white.png"
        alt={alt}
        width={size}
        height={size}
        className={cn("hidden shrink-0 object-contain dark:block", className)}
      />
    </>
  );
}
