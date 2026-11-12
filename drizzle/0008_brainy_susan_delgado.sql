CREATE TABLE `summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`version` integer NOT NULL,
	`through_run_id` text,
	`text` text NOT NULL,
	`artifacts` text NOT NULL,
	`tokens_used` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_version_idx` ON `summaries` (`channel_id`,`version`);