CREATE TABLE `goal_states` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`run_id` text,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_states_version_idx` ON `goal_states` (`goal_id`,`version`);