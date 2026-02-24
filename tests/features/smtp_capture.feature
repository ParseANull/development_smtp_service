Feature: SMTP Message Capture
  As a developer
  I want captured emails to be stored and retrievable via the REST API
  So that I can inspect outgoing emails during development without delivering them

  Background:
    Given an empty message store

  Scenario: Capturing a single email
    When a message is added with subject "Welcome Email" from "app@example.com" to "user@example.com"
    Then the store should contain 1 message
    And the first message should have subject "Welcome Email"

  Scenario: Capturing multiple emails
    When a message is added with subject "First" from "a@example.com" to "b@example.com"
    And a message is added with subject "Second" from "a@example.com" to "b@example.com"
    Then the store should contain 2 messages

  Scenario: Deleting a captured email
    Given a message is added with subject "Delete Me" from "a@example.com" to "b@example.com"
    When the message "Delete Me" is deleted
    Then the store should contain 0 messages

  Scenario: Clearing all emails
    Given a message is added with subject "First" from "a@example.com" to "b@example.com"
    And a message is added with subject "Second" from "a@example.com" to "b@example.com"
    When all messages are cleared
    Then the store should contain 0 messages

  Scenario: Respecting the maximum message limit
    Given a store with a maximum of 3 messages
    When 5 messages are added
    Then the store should contain 3 messages
