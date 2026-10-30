import { z } from "zod";

/** What the landing relays. Lengths match the landing form's limits. */
export const availabilityInput = z.object({
  address: z.string().trim().min(3).max(300),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const confirmInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  company: z.string().trim().min(1).max(160),
  address: z.string().trim().min(3).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  start: z.iso.datetime(),
  notes: z.string().max(2000).default(""),
});
