ALTER TABLE `runs` ADD `goal_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `trigger` text DEFAULT 'user' NOT NULL;