/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import React, { FunctionComponent } from 'react';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n/react';
import { EuiCode } from '@elastic/eui';

import { FieldNameField } from './common_fields/field_name_field';
import { TargetField } from './common_fields/target_field';
import { IgnoreMissingField } from './common_fields/ignore_missing_field';

export const Lowercase: FunctionComponent = () => {
  return (
    <>
      <FieldNameField
        helpText={i18n.translate(
          'xpack.ingestPipelines.pipelineEditor.lowerCaseForm.fieldNameHelpText',
          { defaultMessage: 'Field to lowercase.' }
        )}
      />

      <TargetField
        helpText={
          <FormattedMessage
            id="xpack.ingestPipelines.pipelineEditor.lowerCaseForm.targetFieldHelpText"
            defaultMessage="Field to assign the converted value to. Defaults to {field}."
            values={{
              field: <EuiCode>{'field'}</EuiCode>,
            }}
          />
        }
      />

      <IgnoreMissingField />
    </>
  );
};