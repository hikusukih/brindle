CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_name` text NOT NULL,
	`run_id` text,
	`file` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_scope_idx` ON `artifacts` (`scope`,`scope_id`);--> statement-breakpoint
CREATE INDEX `artifacts_created_idx` ON `artifacts` (`created_at`);