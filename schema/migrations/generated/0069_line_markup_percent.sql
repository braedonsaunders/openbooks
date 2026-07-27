-- Markup needs its own field. cost_multiplier is a rate factor for the work
-- itself (1.5 overtime, 2 double time); billing had been overloading it as the
-- rebill markup, so a source system recording "15" percent produced fifteen
-- times the cost. Percent, never a fraction: 15 means 15%.
alter table "document_lines" add column if not exists "markup_percent" numeric(19,4);
