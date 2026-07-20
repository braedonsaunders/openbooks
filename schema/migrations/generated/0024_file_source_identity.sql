ALTER TABLE "files" ADD COLUMN "source_system" text;
ALTER TABLE "files" ADD COLUMN "source_id" text;
CREATE UNIQUE INDEX "files_source_identity"
  ON "files" USING btree ("org_id", "source_system", "source_id");
