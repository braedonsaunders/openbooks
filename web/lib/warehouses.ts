import { z } from 'zod'

/**
 * Warehouse address fields shared by the create and update routes. A blank
 * or null value clears the field; the engine validates the country code.
 */
export const warehouseAddressBody = {
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  postalCode: z.string().max(40).nullable().optional(),
  country: z.string().max(2).nullable().optional(),
}
