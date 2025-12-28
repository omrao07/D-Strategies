############################################
# Variables
############################################

variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "name" {
  type    = string
  default = "hyper-os"
}

variable "labels" {
  type    = map(string)
  default = { project = "hyper-os" }
}

# CMEK
variable "use_cmek" {
  type    = bool
  default = false
}

variable "kms_key" {
  type    = string
  default = null
}

variable "create_kms" {
  type    = bool
  default = false
}

variable "kms_location" {
  type    = string
  default = "us"
}

# Logging
variable "enable_access_logs" {
  type    = bool
  default = true
}

# Lifecycle
variable "lifecycle_nearline_days" {
  type    = number
  default = 30
}

variable "lifecycle_coldline_days" {
  type    = number
  default = 180
}

variable "lifecycle_archive_days" {
  type    = number
  default = 365
}

variable "object_retention_days" {
  type    = number
  default = 0
}

variable "enable_versioning" {
  type    = bool
  default = true
}

# Notifications
variable "enable_notifications" {
  type    = bool
  default = false
}

variable "notify_events" {
  type    = list(string)
  default = ["OBJECT_FINALIZE"]
}

############################################
# Project & locals
############################################

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  suffix       = data.google_project.this.number
  uniform_acl  = true

  raw_bucket  = "${var.name}-lake-raw-${local.suffix}"
  proc_bucket = "${var.name}-lake-processed-${local.suffix}"
  cur_bucket  = "${var.name}-lake-curated-${local.suffix}"
  logs_bucket = "${var.name}-lake-logs-${local.suffix}"

  cmek_key_id = (
    var.use_cmek
    ? (var.create_kms ? google_kms_crypto_key.lake[0].id : var.kms_key)
    : null
  )
}

############################################
# CMEK (optional)
############################################

resource "google_kms_key_ring" "lake" {
  count    = var.use_cmek && var.create_kms ? 1 : 0
  project  = var.project_id
  name     = "${var.name}-lake-ring"
  location = var.kms_location
}

resource "google_kms_crypto_key" "lake" {
  count    = var.use_cmek && var.create_kms ? 1 : 0
  name     = "${var.name}-lake-key"
  key_ring = google_kms_key_ring.lake[0].id

  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = false
  }
}

############################################
# Logs bucket
############################################

resource "google_storage_bucket" "logs" {
  count    = var.enable_access_logs ? 1 : 0
  project  = var.project_id
  name     = local.logs_bucket
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { tier = "logs" })

  dynamic "encryption" {
    for_each = local.cmek_key_id != null ? [1] : []
    content {
      default_kms_key_name = local.cmek_key_id
    }
  }

  versioning {
    enabled = var.enable_versioning
  }
}

############################################
# Lake buckets (raw / processed / curated)
############################################

locals {
  lake_buckets = {
    raw       = local.raw_bucket
    processed = local.proc_bucket
    curated   = local.cur_bucket
  }
}

resource "google_storage_bucket" "lake" {
  for_each = local.lake_buckets

  project  = var.project_id
  name     = each.value
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { tier = each.key })

  dynamic "encryption" {
    for_each = local.cmek_key_id != null ? [1] : []
    content {
      default_kms_key_name = local.cmek_key_id
    }
  }

  versioning {
    enabled = var.enable_versioning
  }

  dynamic "logging" {
    for_each = var.enable_access_logs ? [1] : []
    content {
      log_bucket        = google_storage_bucket.logs[0].name
      log_object_prefix = each.key
    }
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
    condition {
      age = var.lifecycle_nearline_days
    }
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
    condition {
      age = var.lifecycle_coldline_days
    }
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
    condition {
      age = var.lifecycle_archive_days
    }
  }

  dynamic "retention_policy" {
    for_each = var.object_retention_days > 0 ? [1] : []
    content {
      retention_period = var.object_retention_days * 86400
      is_locked        = false
    }
  }
}

############################################
# Pub/Sub notifications (optional)
############################################

resource "google_pubsub_topic" "lake_events" {
  count   = var.enable_notifications ? 1 : 0
  name    = "${var.name}-lake-events"
  project = var.project_id
  labels  = var.labels
}

resource "google_pubsub_topic_iam_member" "bucket_publishers" {
  for_each = var.enable_notifications ? local.lake_buckets : {}

  topic  = google_pubsub_topic.lake_events[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${local.suffix}@gs-project-accounts.iam.gserviceaccount.com"
}

resource "google_storage_notification" "lake_notify" {
  for_each = var.enable_notifications ? local.lake_buckets : {}

  bucket         = google_storage_bucket.lake[each.key].name
  payload_format = "JSON_API_V1"
  topic          = google_pubsub_topic.lake_events[0].id
  event_types    = var.notify_events
}

############################################
# Outputs
############################################

output "gcs_lake_buckets" {
  value = {
    raw       = google_storage_bucket.lake["raw"].name
    processed = google_storage_bucket.lake["processed"].name
    curated   = google_storage_bucket.lake["curated"].name
    logs      = var.enable_access_logs ? google_storage_bucket.logs[0].name : null
  }
}

output "gcs_cmek_key" {
  value       = local.cmek_key_id
  description = "CMEK key used for bucket encryption (null if Google-managed)"
}