############################################
# Variables
############################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "instance_name" {
  type        = string
  description = "Cloud Spanner instance name"
}

variable "region" {
  type        = string
  default     = "regional-us-central1"
}

variable "databases" {
  description = "Spanner databases and their DDL"
  type = map(object({
    ddl = list(string)
  }))
}

variable "db_admins" {
  type        = list(string)
  default     = []
  description = "IAM users with admin access"
}

variable "db_users" {
  type        = list(string)
  default     = []
  description = "IAM users with read/write access"
}

variable "db_readers" {
  type        = list(string)
  default     = []
  description = "IAM users with read-only access"
}

############################################
# Spanner Instance
############################################

resource "google_spanner_instance" "this" {
  name         = var.instance_name
  project      = var.project_id
  config       = var.region
  display_name = var.instance_name
  num_nodes    = 1
}

############################################
# Spanner Databases
############################################

resource "google_spanner_database" "databases" {
  for_each = var.databases

  name     = each.key
  project  = var.project_id
  instance = google_spanner_instance.this.name
  ddl      = each.value.ddl
}

############################################
# IAM Bindings
############################################

resource "google_spanner_database_iam_binding" "admins" {
  for_each = google_spanner_database.databases

  project  = var.project_id
  instance = var.instance_name
  database = each.key
  role     = "roles/spanner.databaseAdmin"
  members  = var.db_admins
}

resource "google_spanner_database_iam_binding" "users" {
  for_each = google_spanner_database.databases

  project  = var.project_id
  instance = var.instance_name
  database = each.key
  role     = "roles/spanner.databaseUser"
  members  = var.db_users
}

resource "google_spanner_database_iam_binding" "readers" {
  for_each = google_spanner_database.databases

  project  = var.project_id
  instance = var.instance_name
  database = each.key
  role     = "roles/spanner.databaseReader"
  members  = var.db_readers
}