-- Refuse identity conversion unless every sales configuration user names an
-- employee in the same organization. The Users drawer edits that native link.
WITH references_to_convert AS (
 SELECT org_id,manager_user_id AS user_id,'Sales team manager'::text AS kind,id FROM public.crm_sales_teams WHERE manager_user_id IS NOT NULL
 UNION ALL SELECT org_id,user_id,'Sales team member',id FROM public.crm_sales_team_members
 UNION ALL SELECT org_id,manager_user_id,'Territory manager',id FROM public.crm_sales_territories WHERE manager_user_id IS NOT NULL
 UNION ALL SELECT org_id,default_owner_user_id,'Territory representative',id FROM public.crm_sales_territories WHERE default_owner_user_id IS NOT NULL
 UNION ALL SELECT org_id,user_id,'Opportunity contributor',id FROM public.crm_opportunity_team_members
 UNION ALL SELECT org_id,owner_user_id,'Quota representative',id FROM public.crm_sales_quotas WHERE owner_user_id IS NOT NULL
)
SELECT '0470.unlinked_sales_employee' AS code,'refuse' AS severity,
 r.kind||' '||r.id::text AS subject,
 COALESCE(u.name,'Missing user')||' has no native employee link in the owning organization.' AS detail,
 'Link this login to its existing employee in Company Settings → Users before upgrading.' AS remedy
 FROM references_to_convert r LEFT JOIN public.users u ON u.org_id=r.org_id AND u.id=r.user_id
 LEFT JOIN public.employee_roles e ON e.org_id=r.org_id AND e.party_id=u.party_id
 WHERE e.party_id IS NULL
UNION ALL
SELECT '0470.duplicate_employee_membership','refuse','Sales team '||m.team_id::text,
 'Multiple login memberships resolve to the same employee.',
 'Keep one team membership per employee in CRM setup before upgrading.'
 FROM public.crm_sales_team_members m JOIN public.users u ON u.org_id=m.org_id AND u.id=m.user_id
 WHERE m.is_active GROUP BY m.org_id,m.team_id,u.party_id HAVING count(*)>1;
