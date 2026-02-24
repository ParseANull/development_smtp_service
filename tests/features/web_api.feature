Feature: REST API for Message Management
  As a developer
  I want a REST API to list, view, and delete captured emails
  So that I can integrate with the service programmatically

  Background:
    Given an empty message store and a running web app

  Scenario: Listing messages when inbox is empty
    When I GET "/api/messages"
    Then the response status should be 200
    And the response body should be an empty array

  Scenario: Listing messages after capture
    Given a captured message with subject "Hello World"
    When I GET "/api/messages"
    Then the response status should be 200
    And the response body should contain 1 message

  Scenario: Fetching a specific message
    Given a captured message with id "msg-001" and subject "Specific"
    When I GET "/api/messages/msg-001"
    Then the response status should be 200
    And the response body subject should be "Specific"

  Scenario: Fetching a non-existent message
    When I GET "/api/messages/unknown-id"
    Then the response status should be 404

  Scenario: Deleting a specific message
    Given a captured message with id "msg-del" and subject "Delete Me"
    When I DELETE "/api/messages/msg-del"
    Then the response status should be 204
    And the message "msg-del" should no longer exist

  Scenario: Clearing all messages
    Given a captured message with subject "Hello World"
    When I DELETE "/api/messages"
    Then the response status should be 204

  Scenario: Health check endpoint
    When I GET "/health"
    Then the response status should be 200
    And the response body should contain "ok"
