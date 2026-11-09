CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope_kind` text,
	`scope_id` text,
	`run_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`occurred_at` text NOT NULL,
	`read_at` text,
	`dedupe_key` text,
	`template` text,
	`subject` text,
	`count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_dedupe_idx` ON `reports` (`scope_kind`,`scope_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `reports_scope_idx` ON `reports` (`scope_kind`,`scope_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `reports_kind_idx` ON `reports` (`kind`,`occurred_at`);