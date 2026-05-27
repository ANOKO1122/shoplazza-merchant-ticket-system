# Create a webhook

Create a webhook with a unique identifier, notification URL, event name, and format.

# OpenAPI definition

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "OpenAPI",
    "description": "Shoplazza OpenAPI",
    "version": "v202506"
  },
  "servers": [
    {
      "url": "https://{subdomain}.myshoplaza.com",
      "variables": {
        "subdomain": {
          "default": "developer"
        }
      }
    }
  ],
  "paths": {
    "/openapi/2025-06/webhooks": {
      "post": {
        "tags": [
          "Webhook"
        ],
        "summary": "Create a webhook",
        "description": "Create a webhook with a unique identifier, notification URL, event name, and format.",
        "operationId": "create-webhook-v202506",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateWebhookRequest"
              }
            }
          },
          "required": true
        },
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CreateWebhookResponse"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "CreateWebhookParam": {
        "required": [
          "address",
          "topic"
        ],
        "type": "object",
        "properties": {
          "address": {
            "type": "string",
            "description": "Webhook notification URL, e.g. https://example.com/webhook"
          },
          "topic": {
            "type": "string",
            "description": "The topic of the webhook"
          }
        }
      },
      "CreateWebhookRequest": {
        "required": [
          "webhook"
        ],
        "type": "object",
        "properties": {
          "webhook": {
            "$ref": "#/components/schemas/CreateWebhookParam"
          }
        }
      },
      "CreateWebhookResponse": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "description": "error code"
          },
          "message": {
            "type": "string",
            "description": "error message"
          },
          "data": {
            "$ref": "#/components/schemas/CreateWebhookResponse_Data"
          }
        }
      },
      "CreateWebhookResponse_Data": {
        "type": "object",
        "properties": {
          "webhook": {
            "$ref": "#/components/schemas/WebhookParam"
          }
        }
      },
      "WebhookParam": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The unique identifier of the webhook."
          },
          "address": {
            "type": "string",
            "description": "Webhook notification URL, e.g. https://example.com/webhook"
          },
          "topic": {
            "type": "string",
            "description": "The topic of the webhook."
          },
          "created_at": {
            "type": "string",
            "description": "The time of the webhook was created."
          },
          "updated_at": {
            "type": "string",
            "description": "The time of the webhook was updated."
          },
          "format": {
            "type": "string",
            "description": "The format of the webhook."
          }
        }
      }
    },
    "securitySchemes": {
      "sec0": {
        "type": "apiKey",
        "name": "access-token",
        "in": "header",
        "x-default": "WPMSdB6M8Cpum4X1GoMYOKZpiESd8d2x7dZW8d79ZeQ"
      }
    }
  },
  "security": [
    {
      "sec0": []
    }
  ],
  "x-readme-fauxas": true,
  "x-readme": {
    "headers": [],
    "explorer-enabled": true,
    "proxy-enabled": true
  }
}
```