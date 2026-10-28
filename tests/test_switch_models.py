import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'packages/skills-catalog/catalog/optional/paperclip-operations/switch-agent-models/scripts/switch_models.py'
spec = importlib.util.spec_from_file_location('switch_models', SCRIPT)
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)

class SwitchModelsTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(connection_model='vendor/new(high)', model=None, drop_suffix=False)
        self.catalog = [dict(id='bound', kind='openrouter', models={'vendor/old'}), dict(id='other', kind='gateway', models={'vendor/new'})]

    def agent(self, harness='opencode_local'):
        return dict(id='a', name='A', adapterType=harness, adapterConfig={'model': 'openrouter/vendor/old(high)'}, runtimeConfig={'aiConnection': {'connectionId': 'bound'}})

    def test_bound_route_does_not_depend_on_target_membership(self):
        model, note = switch.target_model(self.agent(), self.args, self.catalog)
        self.assertEqual(model, 'openrouter/vendor/new(high)')
        self.assertFalse(switch.validate(self.agent(), model, self.catalog, None)[0])

    def test_pi_openrouter_prefix(self):
        self.assertEqual(switch.target_model(self.agent('pi_local'), self.args, self.catalog)[0], 'openrouter/vendor/new(high)')

    def test_missing_bound_route_does_not_guess_other_connection(self):
        model, _ = switch.target_model(self.agent(), self.args, self.catalog[1:])
        self.assertIsNone(model)

    def test_suffix_lookup_and_idempotence(self):
        self.catalog[0]['models'].add('vendor/new')
        model, _ = switch.target_model(self.agent(), self.args, self.catalog)
        self.assertTrue(switch.validate(self.agent(), model, self.catalog, None)[0])
        self.assertEqual(model.count('(high)'), 1)

    def test_uuid_does_not_list_companies(self):
        with patch.object(switch, 'list_companies', side_effect=AssertionError('listed')):
            self.assertEqual(switch.resolve_company('01234567-0123-0123-0123-0123456789ab')['id'], '01234567-0123-0123-0123-0123456789ab')

    def test_snapshot_unique_private_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'snapshot.json')
            first = switch.create_snapshot(path, {'v': 1})
            second = switch.create_snapshot(path, {'v': 2})
            self.assertNotEqual(first, second)
            self.assertEqual(stat.S_IMODE(os.stat(first).st_mode), 0o600)
            with patch.object(switch.os, 'replace', side_effect=OSError('failed')):
                with self.assertRaises(OSError):
                    switch.write_snapshot(first, {'v': 3})
            with open(first) as f:
                self.assertEqual(json.load(f), {'v': 1})

    def test_rollback_detects_normalized_null(self):
        snapshot = {'agents': [{'id': 'a', 'name': 'A', 'before': None, 'after': 'new', 'applied': True}], 'companyId': 'c'}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'list_agents', return_value=[{'id':'a', 'adapterConfig': {'model':'new'}}]), patch.object(switch, 'request', return_value=(200, {'adapterConfig': {'model': 'default'}})):
                self.assertEqual(switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True)), 2)

    def test_rollback_rejects_a_different_api_instance(self):
        snapshot = {'apiUrl': 'https://original.example', 'companyId': 'c', 'agents': []}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'api_base', return_value='https://other.example'), patch.object(switch, 'list_agents') as list_agents:
                with self.assertRaises(SystemExit):
                    switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True))
                list_agents.assert_not_called()

    def test_rollback_does_not_overwrite_later_changes(self):
        snapshot = {'agents': [{'id':'a', 'name':'A', 'before':'old', 'after':'new', 'applied':True}], 'companyId':'c'}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'list_agents', return_value=[{'id':'a','adapterConfig':{'model':'later'}}]), patch.object(switch, 'request') as request:
                self.assertEqual(switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True)), 2)
                request.assert_not_called()

if __name__ == '__main__': unittest.main()
