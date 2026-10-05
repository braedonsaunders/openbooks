SELECT '0491.unmapped_stripe_object_type' AS code,'refuse' AS severity,org_id::text AS subject,
 'Stripe billing links hold an object type with no external-links native table mapping.' AS detail,
 'Map the object type to its native table before applying the sales channel migration.' AS remedy
FROM public.stripe_billing_links WHERE object_type NOT IN ('meter','price','customer','subscription','subscription_item') GROUP BY org_id;
