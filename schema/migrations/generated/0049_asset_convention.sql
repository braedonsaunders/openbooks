-- Depreciation convention on asset categories (full_month / mid_month / half_year).
alter table asset_categories add column default_convention text not null default 'full_month';
