import { revalidatePath } from "next/cache";

/**
 * Invalidate every Files surface after a mutation.
 *
 * `revalidatePath("/files")` alone only covers the root listing. Once folders
 * and files have their own routes, a rename made while sitting in one folder
 * has to reach the OTHER folder pages too, or navigating back to one serves it
 * from the client router cache with the old name still on it. The dynamic
 * patterns are the documented way to hit every page matching a route
 * (`revalidatePath.md`: "Use a route pattern plus `type` to refresh all
 * matching pages"), and `type` is required whenever the path has a segment.
 */
export function revalidateFiles(): void {
  revalidatePath("/files");
  revalidatePath("/files/folders/[id]", "page");
  revalidatePath("/files/docs/[id]", "page");
}
