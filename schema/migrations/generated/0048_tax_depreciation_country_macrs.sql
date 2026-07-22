alter table tax_regimes
  add column if not exists country_code text,
  add column if not exists calculation_model text not null default 'pool';

alter table tax_regimes
  drop constraint if exists tax_regimes_calculation_model;
alter table tax_regimes
  add constraint tax_regimes_calculation_model check (calculation_model in ('pool', 'macrs'));

alter table tax_pool_classes
  add column if not exists depreciation_system text,
  add column if not exists macrs_method text,
  add column if not exists recovery_period_years numeric(19, 10),
  add column if not exists convention text;

alter table tax_pool_classes
  drop constraint if exists tax_pool_classes_depreciation_system,
  drop constraint if exists tax_pool_classes_macrs_method,
  drop constraint if exists tax_pool_classes_convention;
alter table tax_pool_classes
  add constraint tax_pool_classes_depreciation_system check (depreciation_system is null or depreciation_system in ('gds', 'ads')),
  add constraint tax_pool_classes_macrs_method check (macrs_method is null or macrs_method in ('200_db', '150_db', 'straight_line')),
  add constraint tax_pool_classes_convention check (convention is null or convention in ('half_year', 'mid_quarter', 'mid_month'));

create index if not exists tax_regimes_org_country on tax_regimes (org_id, country_code);
