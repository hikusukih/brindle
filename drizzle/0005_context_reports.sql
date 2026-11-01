CREATE TABLE `context_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`step` integer NOT NULL,
	`report` text NOT NULL,
	`messages` text,
	`tools` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_reports_channel_idx` ON `context_reports` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `context_reports_run_idx` ON `context_reports` (`run_id`,`step`);