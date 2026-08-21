// import React, { useState } from 'react';
// import { useNavigate } from 'react-router-dom';
// import userService from '../services/userService';
// import Loader from '../components/Loader';

// const CreateUser: React.FC = () => {
//   // const navigate = useNavigate();
//   // const [loading, setLoading] = useState(false);
//   // const [error, setError] = useState<string | null>(null);
//   // const [form, setForm] = useState({
//   //   email: '',
//   //   password: '',
//   //   role: 'user'
//   // });

//   // const categories = [
//   //   { value: 'user', label: 'User' },
//   //   { value: 'manager', label: 'Manager' },
//   //   { value: 'admin', label: 'Admin' }
//   // ];

//   // const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
//   //   setForm((s) => ({ ...s, [e.target.name]: e.target.value }));
//   // };

//   // const handleSubmit = async (e: React.FormEvent) => {
//   //   e.preventDefault();
//   //   setError(null);
//   //   setLoading(true);
//   //   try {
//   //     console.log('Submitting form data from CreateUser tsx file:', JSON.stringify(form, null, 2));  
//   //     await userService.create({
//   //       email: form.email,
//   //       password: form.password,
//   //       role: form.role
//   //     });
//   //     navigate('/users');
//   //   } catch (err: any) {
//   //     setError(err?.response?.data?.detail ?? 'Failed to create user');
//   //     console.error(err);
//   //   } finally {
//   //     setLoading(false);
//   //   }
//   // };

//   // if (loading) return <Loader />;

//   // return (
//   //   <div className="max-w-2xl mx-auto">
//   //     <div className="flex justify-between items-center mb-6">
//   //       <h2 className="text-2xl font-semibold">Create New User</h2>
//   //       <button onClick={() => navigate(-1)} className="px-4 py-2 text-gray-600 hover:text-gray-800">
//   //         Cancel
//   //       </button>
//   //     </div>

//   //     {error && <div className="bg-app-brand-50 text-app-brand-700 p-3 rounded mb-4">{error}</div>}

//   //     <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
//   //       <div>
//   //         <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
//   //         <input
//   //           required
//   //           name="email"
//   //           type="email"
//   //           value={form.email}
//   //           onChange={handleChange}
//   //           className="w-full px-3 py-2 border rounded"
//   //         />
//   //       </div>

//   //       <div>
//   //         <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
//   //         <input
//   //           required
//   //           name="password"
//   //           type="password"
//   //           value={form.password}
//   //           onChange={handleChange}
//   //           className="w-full px-3 py-2 border rounded"
//   //         />
//   //       </div>

//   //       <div>
//   //         <label className="block text-sm font-medium text-gray-700 mb-1">Category / Role *</label>
//   //         <select
//   //           required
//   //           name="role"
//   //           value={form.role}
//   //           onChange={handleChange}
//   //           className="w-full px-3 py-2 border rounded"
//   //         >
//   //           {categories.map((c) => (
//   //             <option key={c.value} value={c.value}>
//   //               {c.label}
//   //             </option>
//   //           ))}
//   //         </select>
//   //       </div>

//   //       <button
//   //         type="submit"
//   //         className="w-full py-2 px-4 bg-blue-600 text-white rounded hover:bg-blue-700"
//   //       >
//   //         Create User
//   //       </button>
//   //     </form>
//   //   </div>
//   // );
// };

// export default CreateUser;