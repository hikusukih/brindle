CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`header_name` text,
	`scope` text NOT NULL,
	`scope_hash` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_live_name` ON `secrets` (`name`) WHERE "secrets"."revoked_at" is null;