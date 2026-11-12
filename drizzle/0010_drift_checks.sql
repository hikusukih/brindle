CREATE TABLE `drift_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`run_id` text NOT NULL,
	`statement_version` integer NOT NULL,
	`on_topic` integer NOT NULL,
	`topic` text,
	`nudged` integer NOT NULL,
	`tokens_used` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drift_checks_channel_idx` ON `drift_checks` (`channel_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `channels` ADD `drift_dismissed_version` integer;