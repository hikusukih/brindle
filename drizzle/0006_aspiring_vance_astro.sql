CREATE TABLE `schedule_fires` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`due_at` text NOT NULL,
	`state` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_fires_due_idx` ON `schedule_fires` (`schedule_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`cron` text NOT NULL,
	`prompt` text NOT NULL,
	`destination` text NOT NULL,
	`enabled` integer NOT NULL,
	`next_fire_at` text,
	`missed_policy` text NOT NULL,
	`created_at` text NOT NULL
);
